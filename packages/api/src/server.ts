import appPromise from './app.js';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    const app = await appPromise;
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer().catch(error => {
  console.error('Unhandled error during server startup:', error);
  process.exit(1);
}); 