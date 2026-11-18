import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DevContinuity',
    short_name: 'DevContinuity',
    description: 'AI development workspace, project recovery and AI organization',
    start_url: '/owner',
    display: 'standalone',
    background_color: '#0B0F19',
    theme_color: '#6366F1',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
