# Webhook Configuration

This document outlines how to configure webhooks for different Git providers to work with LightCI.

## GitHub Webhooks

### Configuration Steps

1. Go to your GitHub repository settings
2. Navigate to "Webhooks" section
3. Click "Add webhook"
4. Configure the following settings:
   - Payload URL: `{API_BASE_URL}/webhook/github`
   - Content type: `application/json`
   - Secret: Set this to a secure random string (same value as `GITHUB_WEBHOOK_SECRET` environment variable)
   - SSL verification: Enabled
   - Events: Select "Just the push event" (or customize based on your needs)

### Environment Variables

Make sure to set the following environment variable in your LightCI server:

```bash
GITHUB_WEBHOOK_SECRET=your_secure_webhook_secret
```

### Supported Events

Currently, the following GitHub webhook events are supported:

- `push`: Triggers pipeline runs for push events to configured branches
- Additional events will be supported in future releases

### Branch Configuration

You can configure which branches trigger pipeline runs in your pipeline configuration:

```json
{
  "triggers": {
    "branches": [
      "main",
      "release/*",
      "*"  // Wildcard to trigger on all branches
    ]
  }
}
```

### Security

- All webhook requests are verified using HMAC SHA-256 signatures
- Invalid signatures will result in request rejection
- Missing webhook secrets will prevent webhook processing

## GitLab Webhooks

[GitLab webhook documentation will be added here]

## Troubleshooting

### Common Issues

1. **Invalid Signature**
   - Verify that the webhook secret in GitHub matches your `GITHUB_WEBHOOK_SECRET` environment variable
   - Check that the content type is set to `application/json`

2. **Pipeline Not Found**
   - Ensure the repository URL in your pipeline configuration matches the GitHub repository URL
   - Check if the pipeline is properly configured in LightCI

3. **Branch Not Triggering**
   - Verify that the branch is included in the pipeline's trigger configuration
   - Check the webhook payload for the correct branch name format

### Webhook Logs

To troubleshoot webhook issues:

1. Check the LightCI server logs for detailed error messages
2. Review the webhook delivery history in GitHub's webhook settings
3. Verify the webhook response status and message

For additional assistance, please open an issue in the LightCI repository. 