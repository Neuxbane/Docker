#!/bin/bash
# Example init script for neuxbane-core container

echo "[init.sh] Container initialization started."
nginx -g 'daemon off;'
echo "[init.sh] Initialization complete."
