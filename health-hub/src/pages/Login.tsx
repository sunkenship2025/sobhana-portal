import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAuthStore, UserRole } from '@/store/authStore';
import { toast } from 'sonner';
import { FlaskConical, Stethoscope, Building2, Users } from 'lucide-react';

const ROLE_CONFIG: Record<UserRole, { label: string; icon: React.ElementType; description: string }> = {
  doctor: { label: 'Doctor', icon: Stethoscope, description: 'View lab reports' },
  owner: { label: 'Owner', icon: Building2, description: 'Business overview & all access' },
  staff: { label: 'Staff', icon: Users, description: 'Diagnostics & Clinic reception' },
};

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
      toast.success(`Welcome! Logged in as ${ROLE_CONFIG[role].label}`);
      // Redirect based on role
      if (role === 'doctor') navigate('/doctor');
      else if (role === 'owner') navigate('/owner');
      else navigate('/');
    } else {
      toast.error(result.error || 'Login failed');
    }
    
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 rounded-full bg-primary/10">
              <FlaskConical className="h-10 w-10 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl">MedCare Login</CardTitle>
          <CardDescription>Sign in to access your dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <div className="space-y-3">
              <Label>Select Role</Label>
              <RadioGroup
                value={role}
                onValueChange={(v) => setRole(v as UserRole)}
                className="grid gap-3"
              >
                {(Object.keys(ROLE_CONFIG) as UserRole[]).map((r) => {
                  const config = ROLE_CONFIG[r];
                  const Icon = config.icon;
                  return (
                    <label
                      key={r}
                      htmlFor={`role-${r}`}
                      className={`flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        role === r ? 'border-primary bg-accent' : 'border-border hover:bg-muted'
                      }`}
                    >
                      <RadioGroupItem value={r} id={`role-${r}`} />
                      <Icon className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1">
                        <span className="font-medium">{config.label}</span>
                        <p className="text-xs text-muted-foreground">{config.description}</p>
                      </div>
                    </label>
                  );
                })}
              </RadioGroup>
            </div>

            <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
              {isLoading ? 'Signing in...' : 'Sign In'}
            </Button>

            <p className="text-xs text-center text-muted-foreground">
              Demo mode: Enter any email/password to login
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
