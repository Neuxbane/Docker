# Use Ubuntu as base image
FROM ubuntu:latest

# Variabel lingkungan untuk non-interactive mode dan konfigurasi
ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR /root/.nvm
ENV MINICONDA_PATH /opt/miniconda

# Menambahkan path Miniconda ke PATH utama
ENV PATH=$MINICONDA_PATH/bin:$PATH

# Memperbarui paket dan menginstal dependensi dasar
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg software-properties-common net-tools nmap \
    openssh-server nginx wget nano mc ca-certificates \
    && add-apt-repository ppa:ondrej/php \
    && apt-get update && apt-get install -y --no-install-recommends \
    php8.4 php8.4-fpm php8.4-cli php8.4-bcmath php8.4-bz2 php8.4-curl \
    php8.4-mbstring php8.4-intl php8.4-mysql php8.4-pgsql \
    php8.4-pdo-mysql php8.4-pdo-pgsql php8.4-xml php8.4-zip php8.4-tokenizer php8.4-gd \
    php8.4-imagick \
    php7.4 php7.4-fpm php7.4-cli php7.4-bcmath php7.4-bz2 php7.4-curl \
    php7.4-mbstring php7.4-intl php7.4-mysql php7.4-pgsql \
    php7.4-pdo-mysql php7.4-pdo-pgsql php7.4-xml php7.4-zip php7.4-tokenizer php7.4-gd \
    php7.4-imagick \
    php5.6 php5.6-fpm php5.6-cli php5.6-bcmath php5.6-bz2 php5.6-curl \
    php5.6-mbstring php5.6-intl php5.6-mysql php5.6-pgsql \
    php5.6-pdo-mysql php5.6-pdo-pgsql php5.6-xml php5.6-zip php5.6-tokenizer php5.6-gd \
    php5.6-imagick \
    imagemagick unzip zip libreoffice \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Instalasi NVM, Node.js, dan NPM, lalu buat symlink agar bisa diakses secara global
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install --lts \
    && ln -s "$NVM_DIR/versions/node/$(nvm version)/bin/node" "/usr/local/bin/node" \
    && ln -s "$NVM_DIR/versions/node/$(nvm version)/bin/npm" "/usr/local/bin/npm" \
    && ln -s "$NVM_DIR/versions/node/$(nvm version)/bin/npx" "/usr/local/bin/npx"

# Instalasi Miniconda 🐍
RUN curl -o miniconda.sh https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh \
    && bash miniconda.sh -b -p $MINICONDA_PATH \
    && rm miniconda.sh \
    && $MINICONDA_PATH/bin/conda clean -tipy

# Instalasi Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Install package CLI global menggunakan npm
RUN npm install -g pm2

# Set locale
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Set default workdir
WORKDIR /workspace

# Create an entrypoint script to start services
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN echo "echo 'Start service here'" > /init.sh \
    && chmod +x /init.sh

# Configure SSH
RUN mkdir /var/run/sshd \
    && echo 'root:@/dev/null' | chpasswd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && mkdir -p /root/.ssh \
    && chmod 700 /root/.ssh

# Use the entrypoint script to start both nginx and SSH services
ENTRYPOINT ["/entrypoint.sh"]

