// Plain-http origins lack crypto.randomUUID; install it before anything mints an id.
import './lib/webRandomUUID';
// Routes can evaluate themed styles as soon as Expo Router loads them.
import './unistyles';
import 'expo-router/entry';
