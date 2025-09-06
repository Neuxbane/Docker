#!/bin/bash

# This script provides a robust, non-interactive installation of Docker Engine
# for major Linux distributions using apt (Debian/Ubuntu) or yum/dnf (RHEL/CentOS/Fedora).

# --- Ensure the script is run as root ---
if [ "$EUID" -ne 0 ]; then
  echo "❌ This script must be run as root. Please use sudo."
  exit 1
fi

# --- Function for Debian/Ubuntu (apt) ---
install_docker_debian() {
    echo "⚙️  Updating apt and installing prerequisites..."
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg

    echo "🔑 Adding Docker's official GPG key..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "📦 Setting up the Docker repository..."
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    echo "🚀 Installing Docker Engine..."
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

# --- Function for RHEL/CentOS/Fedora (yum/dnf) ---
install_docker_rhel() {
    PKG_MANAGER="yum"
    if command -v dnf &> /dev/null; then
        PKG_MANAGER="dnf"
    fi

    echo "⚙️  Removing older Docker versions..."
    $PKG_MANAGER remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine

    echo "📦 Setting up the Docker repository..."
    $PKG_MANAGER install -y yum-utils
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

    echo "🚀 Installing Docker Engine..."
    $PKG_MANAGER install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}


# --- Main Logic ---
echo "🐧 Detecting Linux distribution..."

if command -v apt &> /dev/null; then
    echo "✅ Debian/Ubuntu based system detected. Using apt."
    install_docker_debian
elif command -v yum &> /dev/null || command -v dnf &> /dev/null; then
    echo "✅ RHEL/CentOS/Fedora based system detected. Using yum/dnf."
    install_docker_rhel
else
    echo "❌ Unsupported package manager. This script supports apt and yum/dnf."
    exit 1
fi

# --- Post-installation Steps ---
if [ $? -eq 0 ]; then
    echo "▶️  Starting and enabling Docker service..."
    systemctl start docker
    systemctl enable docker

    if [ -n "$SUDO_USER" ]; then
        echo "👤 Adding user '$SUDO_USER' to the docker group..."
        usermod -aG docker "$SUDO_USER"
    fi

    echo ""
    echo "✅ Docker installation completed successfully!"
    echo "⚠️  You must log out and log back in for the group changes to apply."
    echo "    Afterward, you can run docker commands without sudo."

    # Verify installation
    docker run hello-world
else
    echo "❌ Docker installation failed. Please check the output for errors."
    exit 1
fi

exit 0
