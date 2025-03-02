import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import CreatePipeline from '@/pages/CreatePipeline';
import CreateProject from '@/pages/CreateProject';
import PipelinesPage from '@/pages/PipelinesPage';
import PipelineSettings from '@/pages/PipelineSettings';
import PipelineHistory from '@/pages/PipelineHistory';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import { AuthProvider } from '@/lib/auth.context';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Toaster } from 'sonner';
import { useAuth } from '@/lib/auth.context';

function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 bg-white border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link 
            to="/" 
            className="text-xl font-bold text-blue-600 hover:text-blue-700"
          >
            LightCI
          </Link>
          {user ? (
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-700">
                {user.email}
              </span>
              <button
                onClick={logout}
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="flex items-center space-x-4">
              <Link
                to="/login"
                className="text-sm text-gray-600 hover:text-gray-900"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="text-sm bg-blue-600 text-white px-3 py-2 rounded-md hover:bg-blue-700"
              >
                Sign up
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="relative min-h-screen bg-background">
          <Toaster position="top-right" />
          <Header />
          <main>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />

              {/* Protected routes */}
              <Route
                path="/projects/new"
                element={
                  <ProtectedRoute>
                    <CreateProject />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pipelines/new"
                element={
                  <ProtectedRoute>
                    <CreatePipeline />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pipelines/:id/settings"
                element={
                  <ProtectedRoute>
                    <PipelineSettings />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/pipelines/:id/history"
                element={
                  <ProtectedRoute>
                    <PipelineHistory />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <PipelinesPage />
                  </ProtectedRoute>
                }
              />
            </Routes>
          </main>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;
