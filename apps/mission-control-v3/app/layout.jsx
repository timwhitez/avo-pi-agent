import '@copilotkit/react-ui/styles.css';
import './globals.css';

export const metadata = {
  title: 'AVO × Pi Mission Control',
  description: 'Private CopilotKit control, replay, and trajectory analysis for the AVO × Pi ARC-AGI-3 agent.',
  robots: { index: false, follow: false, nocache: true },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
