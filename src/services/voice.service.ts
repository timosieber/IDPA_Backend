import OpenAI from "openai";
import { Readable } from "stream";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// WebM magic bytes (EBML header)
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// Ogg magic bytes
const OGG_MAGIC = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS"

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
}

class BadRequestError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

class ServiceUnavailableError extends Error {
  statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

class VoiceService {
  private readonly client?: OpenAI;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Detect actual file format from magic bytes
   */
  private detectFormat(buffer: Buffer): { ext: string; mime: string } | null {
    if (buffer.length < 4) return null;

    const header = buffer.subarray(0, 4);

    // Check for WebM/Matroska (EBML header)
    if (header.compare(WEBM_MAGIC) === 0) {
      return { ext: "webm", mime: "audio/webm" };
    }

    // Check for Ogg
    if (header.compare(OGG_MAGIC) === 0) {
      return { ext: "ogg", mime: "audio/ogg" };
    }

    // Check for RIFF/WAV
    if (buffer.length >= 12) {
      const riff = buffer.subarray(0, 4).toString("ascii");
      const wave = buffer.subarray(8, 12).toString("ascii");
      if (riff === "RIFF" && wave === "WAVE") {
        return { ext: "wav", mime: "audio/wav" };
      }
    }

    // Check for MP3 (ID3 tag or sync word)
    const b0 = header[0] ?? 0;
    const b1 = header[1] ?? 0;
    const b2 = header[2] ?? 0;
    if ((b0 === 0x49 && b1 === 0x44 && b2 === 0x33) || // ID3
        (b0 === 0xff && (b1 & 0xe0) === 0xe0)) { // MP3 sync
      return { ext: "mp3", mime: "audio/mpeg" };
    }

    // Check for FLAC
    if (header.toString("ascii") === "fLaC") {
      return { ext: "flac", mime: "audio/flac" };
    }

    return null;
  }

  /**
   * Transcribe audio to text using OpenAI Whisper
   */
  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (!this.client) {
      throw new ServiceUnavailableError("Voice services unavailable (no OpenAI API key)");
    }

    // Validate file size
    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > env.VOICE_MAX_AUDIO_SIZE_MB) {
      throw new BadRequestError(
        `Audio file too large (${sizeMB.toFixed(1)}MB > ${env.VOICE_MAX_AUDIO_SIZE_MB}MB)`
      );
    }

    // Detect actual format from magic bytes
    const detected = this.detectFormat(audioBuffer);
    const headerHex = audioBuffer.subarray(0, 16).toString("hex");

    // Use detected format or fall back to mime type
    let ext: string;
    let actualMime: string;

    if (detected) {
      ext = detected.ext;
      actualMime = detected.mime;
      logger.info(
        { mimeType, detectedFormat: detected, headerHex, bufferSize: audioBuffer.length },
        "Audio format detected from magic bytes"
      );
    } else {
      ext = this.mimeToExtension(mimeType);
      actualMime = ext === "webm" ? "audio/webm" : `audio/${ext}`;
      logger.warn(
        { mimeType, headerHex, bufferSize: audioBuffer.length },
        "Could not detect format from magic bytes, using mime type"
      );
    }

    try {
      // Create a File-like object using Uint8Array to ensure compatibility
      const uint8Array = new Uint8Array(audioBuffer);
      const blob = new Blob([uint8Array], { type: actualMime });
      const file = new File([blob], `audio.${ext}`, { type: actualMime });

      const response = await this.client.audio.transcriptions.create({
        file,
        model: env.OPENAI_WHISPER_MODEL,
        language: "de", // German default
        response_format: "verbose_json",
      });

      logger.info(
        { duration: response.duration, language: response.language },
        "Audio transcribed successfully"
      );

      return {
        text: response.text,
        language: response.language,
        duration: response.duration,
      };
    } catch (error: any) {
      const errorMessage = error?.error?.message || error?.message || "Unknown error";
      logger.error(
        { error, errorMessage, mimeType, ext, actualMime, headerHex, bufferSize: audioBuffer.length },
        "Whisper transcription failed"
      );
      throw new ServiceUnavailableError(`Audio transcription failed: ${errorMessage}`);
    }
  }

  /**
   * Convert text to speech using OpenAI TTS
   */
  async synthesize(
    text: string,
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
  ): Promise<SpeechResult> {
    if (!this.client) {
      throw new ServiceUnavailableError("Voice services unavailable (no OpenAI API key)");
    }

    // Truncate text if too long
    const truncatedText = text.slice(0, env.VOICE_MAX_RESPONSE_CHARS);
    if (text.length > env.VOICE_MAX_RESPONSE_CHARS) {
      logger.warn(
        { original: text.length, truncated: truncatedText.length },
        "TTS text truncated due to length limit"
      );
    }

    try {
      const response = await this.client.audio.speech.create({
        model: env.OPENAI_TTS_MODEL,
        voice: voice || env.OPENAI_TTS_VOICE,
        input: truncatedText,
        response_format: "mp3",
      });

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      logger.info(
        { textLength: truncatedText.length, audioSize: audioBuffer.length },
        "Speech synthesized successfully"
      );

      return {
        audio: audioBuffer,
        contentType: "audio/mpeg",
      };
    } catch (error) {
      logger.error({ error }, "TTS synthesis failed");
      throw new ServiceUnavailableError("Speech synthesis failed");
    }
  }

  private mimeToExtension(mimeType: string): string {
    // Normalize mime type (remove codecs and parameters)
    const baseMimeType = mimeType.toLowerCase().split(";")[0]?.trim() || "audio/webm";

    const mapping: Record<string, string> = {
      "audio/webm": "webm",
      "audio/mp3": "mp3",
      "audio/mpeg": "mp3",
      "audio/mp4": "mp4",
      "audio/m4a": "m4a",
      "audio/x-m4a": "m4a",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/wave": "wav",
      "audio/ogg": "ogg",
      "audio/oga": "oga",
      "audio/flac": "flac",
      "audio/x-flac": "flac",
      "video/webm": "webm", // Sometimes browsers report video/webm for audio-only
      "application/octet-stream": "webm", // Fallback for unknown types
    };

    const ext = mapping[baseMimeType];
    if (!ext) {
      logger.warn({ mimeType, baseMimeType }, "Unknown audio mime type, falling back to webm");
    }
    return ext || "webm";
  }
}

export const voiceService = new VoiceService();
