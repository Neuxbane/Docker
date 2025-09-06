#!/bin/bash

# Start SSH service
service ssh start

# Start PHP FPM service
service php5.6-fpm start
service php7.4-fpm start
service php8.4-fpm start

bash /init.sh

tail -f /dev/null
