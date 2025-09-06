# Docker Console Security Guide

## Security Enhancements Applied

This console.js has been enhanced with multiple security improvements:

### 1. Authentication Security
- **Environment Variable Password**: The hardcoded password has been replaced with `ADMIN_PASSWORD` environment variable
- **Rate Limiting**: Authentication attempts are limited to 5 per 15-minute window per IP
- **Secure Token Generation**: Uses cryptographically secure random tokens
- **Session Management**: Sessions expire after 24 hours and include IP validation

### 2. Input Validation & Sanitization
- **Path Traversal Protection**: All file paths are validated to prevent directory traversal attacks
- **Input Validation**: Service names and project names are validated with regex patterns
- **Safe File Operations**: File paths are resolved and checked against workspace boundaries

### 3. Network Security
- **CORS Configuration**: Restricted to specific origins via `ALLOWED_ORIGINS` environment variable
- **Security Headers**: Added X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, HSTS, and CSP
- **HTTPS Support**: Optional HTTPS with configurable SSL certificates

### 4. Error Handling
- **Information Disclosure Prevention**: Error messages no longer leak sensitive information
- **Consistent Error Responses**: Standardized error format across all endpoints

## Setup Instructions

### 1. Set Environment Variables
```bash
export ADMIN_PASSWORD="your_very_secure_password_here"
export ALLOWED_ORIGINS="http://localhost:3000,https://yourdomain.com"
```

### 2. For HTTPS (Production)
```bash
export USE_HTTPS=true
export HTTPS_PORT=3443
export SSL_KEY_PATH="/path/to/ssl/private.key"
export SSL_CERT_PATH="/path/to/ssl/certificate.crt"
```

### 3. Create SSL Certificates (if using HTTPS)
```bash
mkdir ssl
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes
```

### 4. Run with Minimal Privileges
```bash
# Create a dedicated user
sudo useradd -r -s /bin/false dockerconsole
sudo chown -R dockerconsole:dockerconsole /root/Docker

# Run as the dedicated user
sudo -u dockerconsole ADMIN_PASSWORD=securepass node console.js
```

## Security Best Practices

1. **Use Strong Passwords**: Set a complex `ADMIN_PASSWORD` with at least 12 characters
2. **Enable HTTPS**: Always use HTTPS in production environments
3. **Restrict Network Access**: Use firewalls to limit access to the console
4. **Regular Updates**: Keep Node.js and dependencies updated
5. **Monitor Logs**: Regularly review access logs for suspicious activity
6. **Backup Configuration**: Securely backup SSL certificates and configuration

## Security Features

- ✅ Environment-based authentication
- ✅ Rate limiting on authentication
- ✅ Path traversal protection
- ✅ Input validation and sanitization
- ✅ CORS restrictions
- ✅ Security headers
- ✅ HTTPS support
- ✅ Session management with expiration
- ✅ Error message sanitization
- ✅ File access restrictions

## Monitoring

The application logs security events including:
- Authentication attempts (successful and failed)
- Rate limit violations
- Invalid path attempts
- Session expirations

Monitor these logs regularly for security incidents.
