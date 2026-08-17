import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App.js';
import { queryClient } from './api/query-client.js';
import './styles/tokens.css';
import './styles/global.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
