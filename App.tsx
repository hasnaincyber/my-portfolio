import { useCallback, useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { PortfolioHome } from './components/PortfolioHome';
import { KuConnectPage } from './components/KuConnectPage';
import { ProjectDetailPage } from './components/ProjectDetailPage';
import { AdminDashboard } from './components/AdminDashboard';
import type { PortfolioBundle } from './types/portfolio';

export default function App() {
  const [path, setPath] = useState<string>(() => window.location.pathname || '/');
  const [bundle, setBundle] = useState<PortfolioBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio');
      if (!res.ok) throw new Error('Unable to load portfolio data.');
      const json: PortfolioBundle = await res.json();
      setBundle(json);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Failed to load portfolio.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPortfolio();
  }, [loadPortfolio]);

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((nextPath: string, sectionId?: string) => {
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
      setPath(nextPath);
    }
    if (sectionId) {
      window.setTimeout(() => {
        const el = document.getElementById(sectionId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-[#0B162C] flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <p className="font-display text-xl font-bold tracking-tight">Hasnain Taqvi</p>
          <p className="text-xs font-mono text-[#0B162C]/60">Loading portfolio...</p>
        </div>
      </div>
    );
  }

  if (error || !bundle) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] text-[#0B162C] flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-slate-200 p-8 rounded-xl space-y-4 shadow-sm">
          <h1 className="font-display text-xl font-bold">Unable to Load Portfolio</h1>
          <p className="text-sm text-slate-600">{error || 'Please try again shortly.'}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              loadPortfolio();
            }}
            className="min-h-[44px] px-5 py-2.5 bg-[#0B162C] hover:bg-[#2563EB] text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const projectSlugMatch = path.match(/^\/projects\/([^/]+)$/);
  const activeSlug = projectSlugMatch ? decodeURIComponent(projectSlugMatch[1]) : null;
  const matchedProject =
    activeSlug && activeSlug !== 'ku-connect'
      ? bundle.projects.find((p) => p.slug === activeSlug)
      : null;

  return (
    <div className="min-h-screen bg-white text-[#0B162C]">
      <Navbar currentPath={path} onNavigate={navigate} />

      {path === '/admin' ? (
        <AdminDashboard
          data={bundle}
          onDataChanged={loadPortfolio}
          onBackToSite={() => navigate('/')}
        />
      ) : activeSlug === 'ku-connect' ? (
        <KuConnectPage data={bundle.kuConnect} onBack={() => navigate('/', 'work')} />
      ) : matchedProject ? (
        <ProjectDetailPage
          project={matchedProject}
          onBack={() => navigate('/', 'work')}
          onContact={() => navigate('/', 'contact')}
        />
      ) : (
        <PortfolioHome
          data={bundle}
          onOpenKuConnect={() => navigate('/projects/ku-connect')}
          onOpenProject={(slug) => navigate(`/projects/${slug}`)}
          onOpenAdmin={() => navigate('/admin')}
        />
      )}
    </div>
  );
}
