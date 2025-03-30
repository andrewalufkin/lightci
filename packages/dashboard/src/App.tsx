import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import CreatePipeline from '@/pages/CreatePipeline';
import CreateProject from '@/pages/CreateProject';
import PipelinesPage from '@/pages/PipelinesPage';
import ProjectsPage from '@/pages/ProjectsPage';
import PipelineSettings from '@/pages/PipelineSettings';
import PipelineHistory from '@/pages/PipelineHistory';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import { AuthProvider } from '@/lib/auth.context';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Toaster } from '@/components/ui/toaster';
import { useAuth } from '@/lib/auth.context';
import UserDashboard from './pages/UserDashboard';
import BillingPage from '@/pages/BillingPage';
import { Button } from '@/components/ui/button';
import { 
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useCurrentPage } from '@/lib/hooks/useCurrentPage';
import DeployedApps from '@/pages/DeployedApps';

function Header() {
  const { user, logout } = useAuth();
  const currentPage = useCurrentPage();
  console.log('Header rendering with page:', currentPage);

  return (
    <header className="sticky top-0 z-50 bg-white border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-8">
            <Link 
              to="/" 
              className="text-xl font-bold text-blue-600 hover:text-blue-700"
            >
              LightCI
            </Link>
            {user && (
              <nav>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="flex items-center gap-2 px-4 py-2 text-gray-700 border border-gray-300 hover:bg-gray-50"
                    >
                      <span>{currentPage}</span>
                      <ChevronDown className="h-4 w-4 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent 
                    align="start" 
                    className="w-48 z-50 bg-white rounded-md border border-gray-200 shadow-lg animate-in fade-in-80 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
                    sideOffset={5}
                  >
                    <DropdownMenuItem className="focus:bg-gray-100 focus:outline-none" asChild>
                      <Link to="/" className="w-full">Pipelines</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="focus:bg-gray-100 focus:outline-none" asChild>
                      <Link to="/projects" className="w-full">Projects</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="focus:bg-gray-100 focus:outline-none" asChild>
                      <Link to="/deployed-apps" className="w-full">Deployed Apps</Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="focus:bg-gray-100 focus:outline-none" asChild>
                      <Link to="/billing" className="w-full">Billing</Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </nav>
            )}
          </div>
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
          <Toaster />
          <Header />
          <main className="container mx-auto py-6">
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />

              {/* Protected routes */}
              <Route
                path="/deployed-apps"
                element={
                  <ProtectedRoute>
                    <DeployedApps />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects"
                element={
                  <ProtectedRoute>
                    <ProjectsPage />
                  </ProtectedRoute>
                }
              />
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
                path="/billing"
                element={
                  <ProtectedRoute>
                    <BillingPage />
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
              <Route path="/user/dashboard" element={
                <ProtectedRoute>
                  <UserDashboard />
                </ProtectedRoute>
              } />
            </Routes>
          </main>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;
