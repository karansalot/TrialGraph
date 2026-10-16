FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app/backend
COPY backend/pyproject.toml ./
COPY backend/trialgraph ./trialgraph
RUN pip install -e .
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown -R app /data /app
USER app
EXPOSE 8000
CMD ["uvicorn", "trialgraph.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
