import { useMediaQuery } from './hooks';

const MOBILE_BREAKPOINT = 768;

/** True below the mobile breakpoint (768px). False on the server and the first render. */
export function useIsMobile() {
    return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
