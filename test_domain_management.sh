#!/bin/bash
# test_domain_management.sh
# Script to test domain management functionality

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
  echo -e "\n${BLUE}======================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}======================================${NC}\n"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
  exit 1
}

# Check if jq is installed
if ! command -v jq &> /dev/null; then
  print_error "jq is required but not installed. Please install jq to continue."
fi

# Get API URL and auth token
API_URL=${API_URL:-"http://localhost:3001/api"}
TOKEN=${TOKEN:-""}

if [ -z "$TOKEN" ]; then
  print_error "Please set TOKEN environment variable with a valid authentication token"
fi

# Get deployed app ID to test with
DEPLOYED_APP_ID=${DEPLOYED_APP_ID:-""}

if [ -z "$DEPLOYED_APP_ID" ]; then
  print_header "Fetching a deployed app to test with"
  
  DEPLOYED_APP_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" $API_URL/deployed-apps)
  
  if echo "$DEPLOYED_APP_RESPONSE" | jq -e '.apps' > /dev/null; then
    DEPLOYED_APP_ID=$(echo "$DEPLOYED_APP_RESPONSE" | jq -r '.apps[0].id')
    DEPLOYED_APP_NAME=$(echo "$DEPLOYED_APP_RESPONSE" | jq -r '.apps[0].name')
    
    if [ -z "$DEPLOYED_APP_ID" ] || [ "$DEPLOYED_APP_ID" == "null" ]; then
      print_error "No deployed apps found. Please deploy an app first or provide DEPLOYED_APP_ID."
    else
      print_success "Using deployed app: $DEPLOYED_APP_NAME (ID: $DEPLOYED_APP_ID)"
    fi
  else
    print_error "Failed to fetch deployed apps. API response: $DEPLOYED_APP_RESPONSE"
  fi
fi

# Test domain
TEST_DOMAIN="test-$(date +%s).example.com"

# 1. List domains (should be empty or show existing domains)
print_header "1. Listing domains for deployed app"
LIST_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" $API_URL/domains/app/$DEPLOYED_APP_ID)

if echo "$LIST_RESPONSE" | jq -e '.domains' > /dev/null; then
  DOMAINS_COUNT=$(echo "$LIST_RESPONSE" | jq '.domains | length')
  print_success "Successfully listed domains. Found $DOMAINS_COUNT domains."
  echo "$LIST_RESPONSE" | jq
else
  print_error "Failed to list domains. API response: $LIST_RESPONSE"
fi

# 2. Add a new domain
print_header "2. Adding a new domain: $TEST_DOMAIN"
ADD_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"domain\":\"$TEST_DOMAIN\",\"deployedAppId\":\"$DEPLOYED_APP_ID\"}" \
  $API_URL/domains)

if echo "$ADD_RESPONSE" | jq -e '.id' > /dev/null; then
  DOMAIN_ID=$(echo "$ADD_RESPONSE" | jq -r '.id')
  VERIFY_TOKEN=$(echo "$ADD_RESPONSE" | jq -r '.verifyToken')
  print_success "Successfully added domain. ID: $DOMAIN_ID"
  echo "Verification token: $VERIFY_TOKEN"
  echo "$ADD_RESPONSE" | jq
else
  print_error "Failed to add domain. API response: $ADD_RESPONSE"
fi

# 3. List domains again to verify the domain was added
print_header "3. Verifying domain was added"
LIST_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" $API_URL/domains/app/$DEPLOYED_APP_ID)

if echo "$LIST_RESPONSE" | jq -e ".domains[] | select(.domain == \"$TEST_DOMAIN\")" > /dev/null; then
  print_success "Domain was successfully added and appears in the list"
else
  print_error "Added domain does not appear in the list. API response: $LIST_RESPONSE"
fi

# 4. Attempt to verify the domain (will likely fail in test since we don't actually set up DNS)
print_header "4. Attempting to verify domain"
VERIFY_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  $API_URL/domains/$DOMAIN_ID/verify)

echo "Verification response (likely to fail in test environment):"
echo "$VERIFY_RESPONSE" | jq

# 5. Delete the test domain
print_header "5. Deleting test domain"
DELETE_RESPONSE=$(curl -s -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  $API_URL/domains/$DOMAIN_ID)

if echo "$DELETE_RESPONSE" | jq -e '.success' > /dev/null; then
  print_success "Successfully deleted domain"
else
  print_error "Failed to delete domain. API response: $DELETE_RESPONSE"
fi

# 6. Verify domain was deleted
print_header "6. Verifying domain was deleted"
LIST_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" $API_URL/domains/app/$DEPLOYED_APP_ID)

if echo "$LIST_RESPONSE" | jq -e ".domains[] | select(.domain == \"$TEST_DOMAIN\")" > /dev/null; then
  print_error "Domain still appears in the list after deletion. API response: $LIST_RESPONSE"
else
  print_success "Domain was successfully deleted"
fi

print_header "Domain Management Test Complete"
print_success "All tests passed successfully!" 