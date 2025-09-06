#!/bin/bash

# ==============================================================================
# SKRIP RESET DOCKER
# PERINGATAN: Skrip ini akan menghapus SEMUA kontainer, image, volume,
# dan network Docker. Gunakan dengan sangat hati-hati.
# ==============================================================================

# Minta konfirmasi dari pengguna sebelum melanjutkan
read -p "PERINGATAN: Anda akan menghapus semua data Docker. Apakah Anda benar-benar yakin? [ketik 'yes' untuk melanjutkan]: " CONFIRMATION

# Periksa apakah konfirmasi sesuai
if [ "$CONFIRMATION" != "yes" ]; then
    echo "Proses dibatalkan."
    exit 1
fi

echo "Konfirmasi diterima. Memulai proses reset Docker..."

# 1. Hentikan semua kontainer yang sedang berjalan
echo "Langkah 1/3: Menghentikan semua kontainer yang berjalan..."
# Menambahkan '|| true' untuk mencegah error jika tidak ada kontainer yang berjalan
docker stop $(docker ps -aq) || true

# 2. Hapus semua kontainer, network, volume, dan image (unused & dangling)
# Perintah ini adalah cara paling komprehensif untuk membersihkan sistem
echo "Langkah 2/3: Menghapus semua kontainer, image, volume, dan network..."
docker system prune -a -f --volumes

# 3. Verifikasi pembersihan
echo "Langkah 3/3: Verifikasi status Docker..."
echo ""
echo "Daftar Kontainer:"
docker ps -a
echo ""
echo "Daftar Image:"
docker images
echo ""
echo "Daftar Volume:"
docker volume ls
echo ""

echo "=================================================="
echo "Proses reset Docker telah selesai."
echo "Sistem Docker Anda sekarang dalam keadaan bersih."
echo "=================================================="