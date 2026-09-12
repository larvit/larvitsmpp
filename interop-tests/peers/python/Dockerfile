FROM python:3.12.14-slim-bookworm

RUN pip install --no-cache-dir smpplib==2.2.4

WORKDIR /app
COPY driver.py .

EXPOSE 8080
ENTRYPOINT ["python3", "/app/driver.py"]
CMD ["node", "2775"]
