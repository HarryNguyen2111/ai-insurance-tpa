FROM python:3.12.16-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
WORKDIR /smoke
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY smoke.py workflow.py ./
CMD ["python", "-u", "smoke.py"]
