FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/
COPY web/ ./web/

ENV DATA_DIR=/data \
    PORT=8787
VOLUME /data
EXPOSE 8787

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8787"]
