# LightCI Platform

LightCI is a continuous integration and deployment platform designed to simplify the process of deploying web applications.

## Features

- Automated builds and deployments
- Pipeline management
- Project configuration
- Custom domain management
- User and organization management

## Domain Management

The platform now supports custom domain management, allowing you to:

- Add custom domains to your deployed applications
- Verify domain ownership via DNS TXT records
- Automatically configure SSL certificates using Let's Encrypt
- Route traffic from your custom domains to your deployed applications

### Testing Domain Management

We've provided tools to help test the domain management system:

1. **Shell Script Test**: Run basic API tests
   ```bash
   TOKEN="your-auth-token" ./test_domain_management.sh
   ```

2. **Mock DNS Verification**: Simulate domain verification for testing
   ```bash
   TOKEN="your-auth-token" ./mock_dns_verify.js
   ```

For more detailed instructions, see [DOMAIN_TESTING_README.md](./DOMAIN_TESTING_README.md)

## Installation and Setup

1. Clone the repository
2. Install dependencies
   ```bash
   npm install
   ```
3. Set up environment variables
4. Start the development servers
   ```bash
   # Start API server
   cd packages/api
   npm run dev
   
   # Start Dashboard in another terminal
   cd packages/dashboard
   npm run dev
   ```

## Development

See the documentation in the `docs/` directory for more information on development practices and architecture. 