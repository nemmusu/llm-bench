import { configure } from '@testing-library/react';

// findBy*/waitFor wait up to 5 s (default 1 s): a busy machine or a Linux container renders slower, and a
// passing test still ends as soon as what it waits for shows.
configure({ asyncUtilTimeout: 5000 });
