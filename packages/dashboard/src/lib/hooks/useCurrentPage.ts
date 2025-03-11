import { useLocation } from 'react-router-dom';

export function useCurrentPage() {
  const location = useLocation();
  
  let page = 'Pipelines'; // default value
  
  switch (location.pathname) {
    case '/':
      page = 'Pipelines';
      break;
    case '/projects':
    case '/projects/new':
      page = 'Projects';
      break;
    case '/billing':
      page = 'Billing';
      break;
    default:
      if (location.pathname.startsWith('/pipelines')) page = 'Pipelines';
      if (location.pathname.startsWith('/projects')) page = 'Projects';
      break;
  }

  console.log('Current path:', location.pathname, 'Current page:', page);
  return page;
} 