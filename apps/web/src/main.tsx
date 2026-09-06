import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import './style.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });
const root = document.getElementById('root');
if (!root) throw new Error('Application root missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
