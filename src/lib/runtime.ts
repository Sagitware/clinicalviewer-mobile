import Constants, { ExecutionEnvironment } from 'expo-constants';

/** True inside the Expo Go app, which lacks custom native modules and the app's URL scheme. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
