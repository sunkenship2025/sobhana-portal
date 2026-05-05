import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import { Mail, Lock, LogIn } from 'lucide-react';

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Role is determined by the backend's User record — there's no client-side
    // choice. Post-login routing keys off `result.user.role` so each user
    // lands on their own dashboard regardless of how they came in.
    const result = await login(email, password, 'staff');

    if (result.success) {
      const role = useAuthStore.getState().user?.role;
      toast.success('Welcome back');
      if (role === 'doctor') navigate('/doctor');
      else if (role === 'owner') navigate('/owner');
      else navigate('/');
    } else {
      toast.error(result.error || 'Login failed');
    }

    setIsLoading(false);
  };

  return (
    <div className="h-screen flex overflow-hidden bg-white font-sans antialiased text-gray-900">

      {/* ── Left Hero Panel ──
          Pure CSS hero — gradient + decorative pattern. The previous version
          loaded a Google CDN URL (lh3.googleusercontent.com) which can rot,
          can be tracked by Google, and bleeds the user's referrer. */}
      <div className="hidden lg:flex lg:w-1/2 relative overflow-hidden bg-gradient-to-br from-[#0f1f3f] via-[#1B2B58] to-[#25397a]">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.15) 0, transparent 35%), radial-gradient(circle at 80% 70%, rgba(217,28,43,0.25) 0, transparent 40%), radial-gradient(circle at 50% 100%, rgba(255,255,255,0.08) 0, transparent 50%)',
          }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 24px)',
          }}
        />
        <div className="relative z-10 flex flex-col justify-end p-16 text-white">
          <h2 className="text-4xl font-extrabold mb-4 tracking-tight">
            Advanced Healthcare Management
          </h2>
          <p className="text-lg text-gray-200 opacity-90 max-w-lg">
            Securely access patient records, diagnostics, and administrative tools
            in one unified platform designed for modern medical excellence.
          </p>
        </div>
      </div>

      {/* ── Right Login Panel ── */}
      <div className="w-full lg:w-1/2 flex flex-col justify-center items-center p-8 overflow-y-auto">
        <div className="w-full max-w-md space-y-8">

          {/* Logo Block */}
          <div className="text-center flex flex-col items-center">
            <div className="flex flex-col items-center mb-6">
              {/* Icon-based logo */}
              <div className="flex items-end justify-center mb-1 gap-3">
                <div className="relative w-16 h-14 flex items-end shrink-0">
                  <span
                    className="material-symbols-outlined text-[#1B2B58] text-5xl absolute left-0 bottom-0 z-10"
                    style={{ fontVariationSettings: "'FILL' 1, 'wght' 700" }}
                  >
                    biotech
                  </span>
                  <span
                    className="material-symbols-outlined text-[#D91C2B] text-4xl absolute right-0 bottom-1 z-20 bg-white rounded-full border-2 border-white"
                    style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
                  >
                    medical_services
                  </span>
                </div>
                <h1
                  className="text-5xl font-black text-[#D91C2B] tracking-tighter uppercase leading-none"
                  style={{ fontStretch: 'expanded' }}
                >
                  SOBHANA
                </h1>
              </div>
              <div className="text-[#1B2B58] font-bold text-xs sm:text-sm tracking-[0.15em] uppercase text-center border-t-2 border-[#1B2B58]/20 pt-2 w-full max-w-[340px]">
                Diagnostic Centre &amp; Multi Speciality Clinic
              </div>
            </div>

            <h2 className="text-3xl font-bold text-gray-900 mt-4">Welcome Back</h2>
            <p className="mt-2 text-sm text-gray-500">Sign in to access your dashboard</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="mt-8 space-y-6">
            <div className="space-y-5">

              {/* Email */}
              <div>
                <label htmlFor="email" className="block text-sm font-bold text-[#1B2B58] mb-2">
                  Email address
                </label>
                <div className="relative rounded-md shadow-sm">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    className="pl-10 block w-full rounded-md border border-gray-300 bg-gray-50 text-gray-900 focus:ring-[#D91C2B] focus:border-[#D91C2B] sm:text-sm h-12 transition duration-150 ease-in-out font-medium"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label htmlFor="password" className="block text-sm font-bold text-[#1B2B58] mb-2">
                  Password
                </label>
                <div className="relative rounded-md shadow-sm">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="pl-10 block w-full rounded-md border border-gray-300 bg-gray-50 text-gray-900 focus:ring-[#D91C2B] focus:border-[#D91C2B] sm:text-sm h-12 transition duration-150 ease-in-out font-medium"
                  />
                </div>
              </div>

            </div>

            {/* Sign In Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-bold rounded-md text-white bg-[#D91C2B] hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#D91C2B] shadow-lg shadow-red-500/30 transition-all duration-200 uppercase tracking-wide disabled:opacity-50"
            >
              <span className="absolute left-0 inset-y-0 flex items-center pl-3">
                <LogIn className="h-5 w-5 text-red-200 group-hover:text-white transition-colors" />
              </span>
              {isLoading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>


        </div>
      </div>
    </div>
  );
};

export default Login;
