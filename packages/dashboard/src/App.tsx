import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import CreatePipeline from '@/pages/CreatePipeline';
import PipelinesPage from '@/pages/PipelinesPage';
import PipelineSettings from '@/pages/PipelineSettings';
import PipelineHistory from '@/pages/PipelineHistory';
import { useEffect } from 'react';
import { Toaster } from 'sonner';

function App() {
  useEffect(() => {
    console.log('App component mounted');
  }, []);

  console.log('App component rendering');

  return (
    <Router>
      <div className="relative min-h-screen bg-background">
        <Toaster position="top-right" />
        <header className="sticky top-0 z-50 bg-white border-b">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <Link 
                to="/" 
                className="text-xl font-bold text-blue-600 hover:text-blue-700"
              >
                LightCI
              </Link>
              <Link
                to="/pipelines/new"
                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
              >
                New Pipeline
              </Link>
            </div>
          </div>
        </header>

        <main>
          <Routes>
            <Route path="/pipelines/new" element={<CreatePipeline />} />
            <Route path="/pipelines/:id/settings" element={<PipelineSettings />} />
            <Route path="/pipelines/:id/history" element={<PipelineHistory />} />
            <Route path="/" element={<PipelinesPage />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
