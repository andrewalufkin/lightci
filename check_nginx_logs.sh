#!/bin/bash
# Script to check Nginx logs on EC2 instance

# Default values
EC2_IP="44.202.162.30"
EC2_USER="ec2-user"
DOMAIN="andrewbadams.com"

# Prompt for SSH key path if not provided
if [ -z "$1" ]; then
  echo "Please provide the path to your EC2 SSH key:"
  read -r EC2_KEY
else
  EC2_KEY="$1"
fi

# Check if key exists
if [ ! -f "$EC2_KEY" ]; then
  echo "Error: SSH key file not found at $EC2_KEY"
  exit 1
fi

# Make key permissions correct
chmod 600 "$EC2_KEY"

echo "Using SSH key: $EC2_KEY"
echo "Connecting to: $EC2_USER@$EC2_IP"
echo ""

# Check Nginx status
echo "=== Checking Nginx status ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo systemctl status nginx | head -20"

# Check Nginx configuration
echo -e "\n=== Checking Nginx configuration ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo cat /etc/nginx/conf.d/$DOMAIN.conf"

# Test Nginx configuration
echo -e "\n=== Testing Nginx configuration ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo nginx -t"

# Check Nginx error logs
echo -e "\n=== Checking Nginx error logs ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo cat /var/log/nginx/$DOMAIN-error.log 2>/dev/null || echo 'No error log found'"

# Check Nginx access logs
echo -e "\n=== Checking Nginx access logs ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo tail -50 /var/log/nginx/$DOMAIN-access.log 2>/dev/null || echo 'No access log found'"

# Check what process is listening on port 3000
echo -e "\n=== Checking what process is listening on port 3000 ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "sudo netstat -tlpn | grep :3000"

# List running node processes
echo -e "\n=== Listing Node.js processes ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "ps aux | grep -v grep | grep node"

# Check app directory
echo -e "\n=== Checking app directory ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "ls -la ~/app"

# Test local connectivity to the app 
echo -e "\n=== Testing local connectivity to the application ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "curl -I http://localhost:3000/static/js/bundle.js"

# Test serving the actual bundle.js file through Nginx
echo -e "\n=== Testing Nginx serving bundle.js locally ==="
ssh -o StrictHostKeyChecking=no -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "curl -I -H 'Host: $DOMAIN' http://localhost/static/js/bundle.js" 