import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Microscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/authStore";

const NotFound = () => {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  // Send each role to its own home, via SPA navigation (no full reload).
  const home = user?.role === "owner" ? "/owner" : "/";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-center">
      <div className="flex items-center gap-2 text-foreground">
        <Microscope className="h-7 w-7" />
        <span className="text-lg font-bold tracking-tight">SOBHANA</span>
      </div>
      <div>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">404</h1>
        <p className="mt-2 text-muted-foreground">We couldn't find that page.</p>
      </div>
      <Button asChild>
        <Link to={home}>{user ? "Back to your dashboard" : "Back to home"}</Link>
      </Button>
    </div>
  );
};

export default NotFound;
