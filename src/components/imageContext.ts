import { createContext } from 'react';
import type { ImageController } from '../lib/imageController';

/** Lets each mounted chapter register its images for background downscaling; null (the default) means "don't". */
export const ImageContext = createContext<ImageController | null>(null);
