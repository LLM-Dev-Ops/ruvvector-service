#!/bin/bash
# Deployment script for ruvvector-service to Google Cloud Run
# Run this script after authenticating with: gcloud auth login

set -e

PROJECT_ID="ruv-cloud"
REGION="us-central1"
SERVICE_NAME="ruvvector-service"
IMAGE_NAME="us-central1-docker.pkg.dev/${PROJECT_ID}/ruvvector/${SERVICE_NAME}"

echo "=== RuvVector Service Deployment ==="
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo ""

# Set project
gcloud config set project ${PROJECT_ID}

# Configure Docker for Artifact Registry
echo "Configuring Docker for Artifact Registry..."
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

# Create Artifact Registry repo if it doesn't exist
echo "Ensuring Artifact Registry repo exists..."
gcloud artifacts repositories describe ruvvector --location=${REGION} 2>/dev/null || \
  gcloud artifacts repositories create ruvvector \
    --repository-format=docker \
    --location=${REGION} \
    --description="RuvVector Service images"

# Build and push Docker image
echo "Building Docker image..."
docker build -t ${IMAGE_NAME}:latest .

echo "Pushing to Artifact Registry..."
docker push ${IMAGE_NAME}:latest

# Deploy to Cloud Run with secrets
echo "Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image=${IMAGE_NAME}:latest \
  --region=${REGION} \
  --platform=managed \
  --allow-unauthenticated \
  --memory=256Mi \
  --set-env-vars="NODE_ENV=production,PORT=8080,LOG_LEVEL=info" \
  --set-secrets="RUVVECTOR_DB_HOST=RUVECTOR_DB_HOST:latest,RUVVECTOR_DB_PORT=RUVECTOR_DB_PORT:latest,RUVVECTOR_DB_NAME=RUVECTOR_DB_NAME:latest,RUVVECTOR_DB_USER=RUVECTOR_DB_USER:latest,RUVVECTOR_DB_PASSWORD=RUVECTOR_DB_PASSWORD:latest" \
  --add-cloudsql-instances=ruv-cloud:us-central1:ruvector-postgres

echo ""
echo "=== Deployment Complete ==="
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region=${REGION} --format='value(status.url)')
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Test endpoints:"
echo "  Health:     curl ${SERVICE_URL}/health"
echo "  Learn:      curl -X POST ${SERVICE_URL}/learning/learn -H 'Content-Type: application/json' -d '{\"approved\": true}'"
echo "  Assimilate: curl -X POST ${SERVICE_URL}/learning/assimilate -H 'Content-Type: application/json' -d '{...}'"
