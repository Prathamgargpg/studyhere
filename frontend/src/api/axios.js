import axios from 'axios';

// In local dev, Vite proxies /api to the backend (see vite.config.js).
// In production (e.g. Netlify), set VITE_API_URL to the deployed backend's
// origin, e.g. https://api.yourdomain.com
const baseURL = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const api = axios.create({
  baseURL,
  withCredentials: true,
});

export default api;
