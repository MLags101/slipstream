# Build the browser UI once, then serve it from the API container.  This keeps
# the deployed application to one service and one public port.
FROM node:20-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# This OpenFOAM v2606 image supports both amd64 and arm64 and its entrypoint
# loads the solver environment before starting the command below.
FROM microfluidica/openfoam:2606

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN python3 -m venv /opt/slipstream-venv \
    && /opt/slipstream-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/slipstream-venv/bin/pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend-build /build/frontend/dist /app/ui

ENV PATH="/opt/slipstream-venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    SLIPSTREAM_DATA_DIR=/data \
    SLIPSTREAM_STATIC=/app/ui

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
