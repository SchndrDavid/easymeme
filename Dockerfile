FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY static ./static
EXPOSE 8000
# Shell form so ${PORT} is expanded at runtime; exec replaces the shell so
# uvicorn stays PID 1 and still receives SIGTERM from `docker stop`.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
