import { render, screen } from '@testing-library/react';
import { App } from './App.js';

it('renders the product name', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: '德州计分' })).toBeInTheDocument();
});
