import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, UserRole } from '@/store/authStore';
import { toast } from 'sonner';
import { Stethoscope, Building2, Users, Mail, Lock, LogIn } from 'lucide-react';

const ROLES: { value: UserRole; label: string; icon: React.ElementType; desc: string }[] = [
  { value: 'doctor', label: 'Doctor', icon: Stethoscope, desc: 'View lab reports' },
  { value: 'owner', label: 'Owner', icon: Building2, desc: 'Full Access' },
  { value: 'staff', label: 'Staff', icon: Users, desc: 'Clinic reception' },
];

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('staff');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    const result = await login(email, password, role);

    if (result.success) {
      const roleLabel = ROLES.find((r) => r.value === role)?.label ?? role;
      toast.success('Welcome! Logged in as ' + roleLabel);
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

      {/* ── Left Hero Panel ── */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-[#1B2B58]">
        <img
          src="https://lh3.googleusercontent.com/aida-public/AB6AXuAJCqoXJSoTkrjKSdEXs4DJx4D4x9Ob9KTwKxs0-Y3tT6D2KEWOU076lWn2XD5RTdY3nRmNfOmTFbXYYBqDnqYa9-Sv5OkY9aHwpfWFhrNGPEJXGHfkLTM7KLPDLSVHVhhYI23YmYIEjlrZuW5eivX_iGf3e024KoWLccFyEG4OQF1jba2llN0flFjCh8q4JP1dpm-jsuG1NQZ1zpW9y7pXIzqPQV7vVaIaG4nykeBieWC8y1aYTTiLPB7FNfhW4Qbj--6rzC1maA"
          alt="Medical laboratory"
          className="absolute inset-0 w-full h-full object-cover mix-blend-overlay opacity-60"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#1B2B58]/95 to-[#1B2B58]/50" />
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
                    placeholder="staff@sobhana.com"
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
                    placeholder="Password123"
                    className="pl-10 block w-full rounded-md border border-gray-300 bg-gray-50 text-gray-900 focus:ring-[#D91C2B] focus:border-[#D91C2B] sm:text-sm h-12 transition duration-150 ease-in-out font-medium"
                  />
                </div>
              </div>

              {/* Role Selector */}
              <div>
                <label className="block text-sm font-bold text-[#1B2B58] mb-3">Select Role</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {ROLES.map((r) => {
                    const Icon = r.icon;
                    const isSelected = role === r.value;
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setRole(r.value)}
                        className={[
                          'relative p-4 rounded-lg border transition-all duration-200 h-full flex flex-col items-center text-center cursor-pointer group',
                          isSelected
                            ? 'border-[#D91C2B] ring-1 ring-[#D91C2B] bg-red-50 shadow-sm'
                            : 'border-gray-200 bg-white hover:border-[#D91C2B]',
                        ].join(' ')}
                      >
                        {/* Selected dot indicator */}
                        {isSelected && (
                          <div className="absolute -top-1 -right-1 h-3 w-3 bg-[#D91C2B] rounded-full border-2 border-white z-10" />
                        )}
                        <Icon className={[
                          'h-7 w-7 mb-2 transition-colors',
                          isSelected ? 'text-[#D91C2B]' : 'text-gray-500 group-hover:text-[#D91C2B]',
                        ].join(' ')} />
                        <span className={[
                          'block text-sm font-bold',
                          isSelected ? 'text-[#D91C2B]' : 'text-[#1B2B58]',
                        ].join(' ')}>{r.label}</span>
                        <span className="block text-xs text-gray-500 mt-1">{r.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Remember Me + Forgot Password */}
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  name="remember-me"
                  type="checkbox"
                  className="h-4 w-4 text-[#D91C2B] focus:ring-[#D91C2B] border-gray-300 rounded"
                />
                <label htmlFor="remember-me" className="ml-2 block text-sm font-medium text-gray-700">
                  Remember me
                </label>
              </div>
              <a href="#" className="text-sm font-bold text-[#1B2B58] hover:text-[#D91C2B] transition-colors">
                Forgot password?
              </a>
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
