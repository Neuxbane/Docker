#!/bin/bash

# install_nginx.sh - Install Nginx web server
# Usage: ./install_nginx.sh

echo "Starting Nginx installation..."

# Update package list
apt-get update

# Install nginx
echo "Installing Nginx web server..."
apt-get install -y nginx

# Enable and start nginx service
systemctl enable nginx
systemctl start nginx

# Create backup of original config
cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup

# Check installation
if command -v nginx &> /dev/null; then
    echo "✅ Nginx installed successfully"
    nginx -v
else
    echo "❌ Nginx installation failed"
    exit 1
fi

# Test nginx configuration
nginx -t

echo "Nginx installation completed."
echo "Default configuration files are located in /etc/nginx/"
echo "Document root is typically /var/www/html/"
