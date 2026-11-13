// Imported first by the main entry, so the folder is fixed before any other
// module can read or cache `userData`.
import { app } from 'electron';
import { pinLegacyUserData } from './legacyUserData';

pinLegacyUserData(app);
