#!/bin/bash
set -e

echo "=== Custom start script executing ==="
echo "=== Current directory: $(pwd) ==="
echo "=== Listing dist directory: ==="
ls -la dist/ || echo "dist directory not found!"

echo "=== Running Prisma migrations ==="
npx prisma migrate deploy

echo "=== Migrations complete! ==="
echo "=== Starting Node.js application ==="
exec node dist/index.js
