FROM python:3.11-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir flask-limiter

# Copy app code
COPY . .

# Create default directories
RUN mkdir -p /data/books /data/files /data/music /data/cache

# Env defaults
ENV DECLOUD_PORT=8899
# Bind localhost by default — in containers this means only the container
# itself can reach the app. Override (e.g. -e DECLOUD_HOST=0.0.0.0) when
# fronting it with a sidecar tunnel or reverse proxy, and always set
# DECLOUD_PIN in that case.
ENV DECLOUD_HOST=127.0.0.1
ENV DECLOUD_BOOKS_DIR=/data/books
ENV DECLOUD_FILES_DIR=/data/files
ENV DECLOUD_MUSIC_DIR=/data/music
ENV FLASK_ENV=production
ENV FLASK_DEBUG=0

EXPOSE 8899

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8899/', timeout=3)" || exit 1

CMD ["python", "app.py"]
