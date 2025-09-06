#!/bin/bash

SERVICE_NAME="$1"

if [ -n "$SERVICE_NAME" ]; then
    # Restart only the specified service with force recreation to handle service definition changes
    docker compose up -d --force-recreate "$SERVICE_NAME"
else
    # Restart all services (legacy behavior)
    docker compose down

    # try up to 5 times with incremented IP if networking fails
    for i in {1..5}; do
      if docker compose up -d 2>&1 | grep -q "Address already in use"; then
        # increment the IP
        ip=$(grep -oP 'ipv4_address: \K[0-9.]+' docker-compose.yml)
        if [ -n "$ip" ]; then
          parts=(${ip//./ })
          new_last=$((parts[3] + 1))
          new_ip="${parts[0]}.${parts[1]}.${parts[2]}.${new_last}"
          sed -i "s/ipv4_address: $ip/ipv4_address: $new_ip/" docker-compose.yml
          echo "Incremented IP to $new_ip, retrying..."
        else
          break
        fi
      else
        exit 0
      fi
    done

    # if all retries failed, try one more time without increment
    docker compose up -d
fi