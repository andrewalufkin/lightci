# Domain Management Testing Guide

This guide provides instructions for testing the custom domain management functionality in your application.

## Prerequisites

- The API server must be running
- You need a deployed app in the system to test with
- `jq` command-line tool must be installed
- A valid authentication token is required

## Automated Testing

The `test_domain_management.sh` script will automatically test the domain management API endpoints:

1. Make the script executable:
   ```bash
   chmod +x test_domain_management.sh
   ```

2. Run the tests with your authentication token:
   ```bash
   TOKEN="your-auth-token" ./test_domain_management.sh
   ```

3. Optionally specify a deployed app ID and API URL:
   ```bash
   TOKEN="your-auth-token" DEPLOYED_APP_ID="app-id" API_URL="http://localhost:3001/api" ./test_domain_management.sh
   ```

## Test Process

The script performs the following operations:

1. Lists existing domains for the deployed app
2. Adds a new test domain (format: `test-{timestamp}.example.com`)
3. Verifies the domain appears in the domain list
4. Attempts to verify the domain (note: this will likely fail in a test environment without actual DNS setup)
5. Deletes the test domain
6. Confirms the domain was successfully deleted

## Manual Testing via Dashboard

To test via the Dashboard UI:

1. Log in to the dashboard
2. Navigate to the Deployed Apps page
3. Find your deployed app and click "Manage Domains"
4. Add a new domain
5. Note the verification token
6. (For production testing) Add the verification token as a TXT record in your DNS configuration:
   ```
   _lightci-verify.yourdomain.com. TXT {verification-token}
   ```
7. Click "Verify Domain" after setting up the DNS record
8. Verify the domain shows as verified and active

## Troubleshooting

- **API Connection Issues**: Ensure the API server is running and accessible at the specified URL
- **Authentication Errors**: Verify your token is valid and has not expired
- **Missing Deployed App**: Create a deployment first if no deployed apps are available
- **DNS Configuration**: For complete testing, you'll need access to configure DNS records for a domain you control

## Production Domain Configuration

After a domain is verified:

1. The system configures Nginx for the custom domain on the deployment server
2. SSL certificates are automatically issued via Let's Encrypt
3. The domain becomes active and points to your deployed application

**Note**: The actual domain verification requires adding a TXT record to your domain's DNS configuration, which cannot be fully automated in a test environment. 