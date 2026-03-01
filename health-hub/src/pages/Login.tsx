import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuthStore, UserRole } from '@/store/authStore';
import { toast } from 'sonner';
import { Stethoscope, Building2, Users, Mail, Lock, LogIn } from 'lucide-react';

const ROLE_CONFIG: Record<UserRole, { label: string; icon: React.ElementType; description: string }> = {
  doctor: { label: 'Doctor', icon: Stethoscope, description: 'View lab reports' },
  owner: { label: 'Owner', icon: Building2, description: 'Full Access' },
  staff: { label: 'Staff', icon: Users, description: 'Clinic reception' },
};

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('staff');
  const [isLoading, setIsLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const result = await login(email, password, role);

    if (result.success) {
      toast.success('Welcome! Logged in as ' + ROLE_CONFIG[role].label);
      if (role === 'doctor') navigate('/doctor');
      else if (role === 'owner') navigate('/owner');
      else navigate('/');
    } else {
      toast.error(result.error || 'Login failed');
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex">
      {/* Left Panel — Hero */}
      <div className="hidden lg:flex lg:w-[45%] relative bg-[#0f1b3d] flex-col justify-end p-10 overflow-hidden">
        {/* Background image overlay */}
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: 'url(/pngtree-flat-microscope-image_1174913.jpg)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
        <div className="relative z-10 text-white space-y-3 mb-8">
          <h1 className="text-3xl font-bold leading-tight">
            Advanced Healthcare<br />Management
          </h1>
          <p className="text-white/70 text-sm leading-relaxed max-w-sm">
            Securely access patient records, diagnostics, and
            administrative tools in one unified platform designed for
            modern medical excellence.
          </p>
        </div>
      </div>

      {/* Right Panel — Login Form */}
      <div className="flex-1 flex items-center justify-center bg-white px-6 py-10">
        <div className="w-full max-w-md space-y-8">
          {/* Logo */}
          <div className="text-center space-y-2">
            <img
              src="/sobhana-whitebg.png"
              alt="Sobhana"
              className="h-16 mx-auto object-contain"
            />
            <p className="text-[11px] font-semibold tracking-[0.15em] text-[#0f1b3d] uppercase">
              Diagnostic Centre &amp; Multi<br />Speciality Clinic
            </p>
          </div>

          {/* Heading */}
          <div className="text-center space-y-1">
            <h2 className="text-2xl font-bold text-gray-900">Welcome Back</h2>
            <p className="text-sm text-gray-500">Sign in to access your dashboard</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium text-gray-700">
                Email address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  placeholder="staff@sobhana.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-11 border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 h-11 border-gray-300 bg-white text-gray-900 placeholder:text-gray-400"
                  required
                />
              </div>
            </div>

            {/* Role Selector */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Select Role</label>
              <div className="grid grid-cols-3 gap-3">
                {(Object.keys(ROLE_CONFIG) as UserRole[]).map((r) => {
                  const config = ROLE_CONFIG[r];
                  const Icon = config.icon;
                  const isSelected = role === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRole(r)}
                      className={[
                        'flex flex-col items-center gap-1.5 p-4 rounded-lg border-2 transition-all cursor-pointer',
                        isSelected
                          ? 'border-red-500 bg-red-50 shadow-sm'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      <Icon className={[
                        'h-6 w-6',
                        isSelected ? 'text-red-600' : 'text-gray-500',
                      ].join(' ')} />
                      <span className={[
                        'text-sm font-semibold',
                        isSelected ? 'text-red-700' : 'text-gray-700',
                      ].join(' ')}>{config.label}</span>
                      <span className="text-[10px] text-gray-400 leading-tight text-center">
                        {config.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Remember Me + Forgot Password */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="remember"
                  checked={rememberMe}
                  onCheckedChange={(v) => setRememberMe(v === true)}
                />
                <label htmlFor="remember" className="text-sm text-gray-600 cursor-pointer select-none">
                  Remember me
                </label>
              </div>
              <button type="button" className="text-sm text-red-600 hover:text-red-700 font-medium">
                Forgot password?
              </button>
            </div>

            {/* Sign In Button */}
            <Button
              type="submit"
              className="w-full h-12 bg-red-600 hover:bg-red-700 text-white text-base font-semibold rounded-lg shadow-md"
              disabled={isLoading}
            >
              <LogIn className="h-4 w-4 mr-2" />
              {isLoading ? 'Signing in...' : 'SIGN IN'}
            </Button>

            {/* Footer */}
            <div className="text-center space-y-1 pt-2">
              <p className="text-xs text-gray-400">
                Demo mode: Enter any email/password to login
              </p>
              <p className="text-xs text-gray-400">
                &copy; 2023 Sobhana Portal. All rights reserved.
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Login;
