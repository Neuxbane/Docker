#!/bin/bash

SERVICE_NAME="$1"

if [ -n "$SERVICE_NAME" ]; then
    # Stop only the specified service
    docker compose stop "$SERVICE_NAME"
else
    # Stop all services (legacy behavior)
    docker compose down
fi