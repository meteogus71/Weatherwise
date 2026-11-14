FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv libeccodes0 libeccodes-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

RUN python3 -m pip install --no-cache-dir --break-system-packages \
    "ecmwf-opendata>=0.3.19" "eccodes>=2.39.0" "cdsapi>=0.7.7"

COPY . .
ENV PYTHON_BIN=python3
EXPOSE 3000
CMD ["npm", "start"]
