#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <hermes/hermes.h>
#if __has_include(<VerityCPUProfiler/VerityCPUProfiler-Swift.h>)
#import <VerityCPUProfiler/VerityCPUProfiler-Swift.h>
#else
#import <VerityCPUProfiler-Swift.h>
#endif
#include <time.h>
#include <pthread.h>
#include <mutex>

// The watchdog and lifecycle stop run on this queue, independently of JS. Never
// access a jsi::Runtime here: only the process-wide, thread-safe sampler API.
@interface VerityCPUProfiler : NSObject <RCTBridgeModule, RCTInvalidating>
@end

// Hermes sampling is process-wide, while reload can overlap bridge instances.
// Serialize ownership so an old bridge cannot stop a replacement's recording.
static std::mutex samplerMutex;
static __weak VerityCPUProfiler *samplerOwner;

@implementation VerityCPUProfiler {
  dispatch_queue_t _queue;
  dispatch_source_t _watchdog;
  id _backgroundObserver;
  BOOL _recording;
  BOOL _invalidated;
  NSString *_captureID;
  NSDictionary *_bundleIdentity;
  NSString *_jsThreadID;
  NSString *_failure;
  NSString *_stopReason;
  NSURL *_directory;
  NSNumber *_startedAt;
  NSNumber *_startedMonotonicUs;
  NSNumber *_stoppedMonotonicUs;
  NSNumber *_stoppedAt;
}
RCT_EXPORT_MODULE(VerityCPUProfiler)

+ (BOOL)requiresMainQueueSetup { return NO; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("build.verity.cpu-profiler", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_queue, (__bridge const void *)self, (__bridge void *)self, NULL);
    __weak VerityCPUProfiler *weakSelf = self;
    _backgroundObserver = [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:nil
      usingBlock:^(NSNotification *notification) {
        VerityCPUProfiler *owner = weakSelf;
        if (owner) dispatch_async(owner->_queue, ^{ [owner finish:@"background"]; });
      }];
  }
  return self;
}
- (dispatch_queue_t)methodQueue { return _queue; }
- (BOOL)enabled {
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  return !_invalidated && [NSBundle.mainBundle.bundleIdentifier isEqual:@"build.verity.app.staging"] &&
    [info[@"VerityCPUProfiling"] boolValue];
}
- (NSURL *)rawURL { return [_directory URLByAppendingPathComponent:@"profile.hermesprofile"]; }
- (NSDictionary *)snapshot {
  return @{@"recording": @(_recording), @"captureId": _captureID ?: @"",
    @"startedAt": _startedAt ?: @0, @"stoppedAt": _stoppedAt ?: @0,
    @"startedMonotonicUs": _startedMonotonicUs ?: @0, @"stoppedMonotonicUs": _stoppedMonotonicUs ?: @0,
    @"reason": _stopReason ?: @"", @"error": _failure ?: @"",
    @"ready": @(_captureID != nil && !_recording && !_failure)};
}
- (void)finish:(NSString *)reason {
  std::lock_guard<std::mutex> lock(samplerMutex);
  if (!_recording) return;
  _recording = NO;
  _stoppedMonotonicUs = @(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000);
  _stopReason = reason;
  _stoppedAt = @([NSDate.date timeIntervalSince1970] * 1000);
  if (_watchdog) { dispatch_source_cancel(_watchdog); _watchdog = nil; }
  auto *api = facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
  if (!api) { _failure = @"Hermes sampling API is unavailable."; return; }
  // Disable before serializing: a delayed JS callback cannot extend sampling.
  if (samplerOwner != self) { _failure = @"CPU recording ownership changed."; return; }
  api->disableSamplingProfiler();
  samplerOwner = nil;
  try {
    api->dumpSampledTraceToFile(self.rawURL.path.UTF8String);
    NSNumber *size;
    [self.rawURL getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
    if (!size || size.unsignedLongLongValue == 0 || size.unsignedLongLongValue > 8 * 1024 * 1024) {
      _failure = @"Profile missing or exceeds 8 MiB; repeat a shorter recording.";
      [NSFileManager.defaultManager removeItemAtURL:self.rawURL error:nil];
    }
  } catch (...) {
    _failure = @"Hermes could not serialize the CPU profile.";
  }
}
RCT_EXPORT_METHOD(status:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@{@"supported": @([self enabled]), @"capture": [self snapshot]});
}
// Blocking synchronous methods execute on the calling JS thread. Record its
// native ID, so a different Hermes/worklet runtime cannot masquerade as main JS.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(jsThreadId) {
  uint64_t tid = 0;
  pthread_threadid_np(NULL, &tid);
  return [NSString stringWithFormat:@"%llu", (unsigned long long)tid];
}
RCT_EXPORT_METHOD(start:(NSString *)jsThreadID resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self enabled]) { reject(@"unsupported", @"Use a staging build with CPU recording support.", nil); return; }
  if (_recording) { reject(@"busy", @"A CPU recording is already running.", nil); return; }
  NSError *identityError;
  NSDictionary *identity = [VerityProfileBundleIdentity snapshotAndReturnError:&identityError];
  if (!identity) { reject(@"identity", @"Could not identify the running bundle.", identityError); return; }
  std::lock_guard<std::mutex> lock(samplerMutex);
  if (samplerOwner && samplerOwner != self) {
    reject(@"busy", @"Another bridge is still finishing a CPU recording. Retry after reload.", nil); return;
  }
  _bundleIdentity = [identity copy];
  _directory = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask].firstObject
    URLByAppendingPathComponent:@"verity-cpu-profile" isDirectory:YES];
  [NSFileManager.defaultManager removeItemAtURL:_directory error:nil];
  NSError *error;
  if (![NSFileManager.defaultManager createDirectoryAtURL:_directory withIntermediateDirectories:YES attributes:nil error:&error]) {
    reject(@"storage", @"Could not create profile storage.", error); return;
  }
  _captureID = NSUUID.UUID.UUIDString;
  _jsThreadID = jsThreadID;
  _failure = nil; _stopReason = nil; _stoppedAt = nil;
  _startedAt = @([NSDate.date timeIntervalSince1970] * 1000);
  _startedMonotonicUs = @(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000);
  _stoppedMonotonicUs = nil;
  auto *api = facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
  if (!api) { _failure = @"Hermes sampling API is unavailable."; reject(@"sampler", _failure, nil); return; }
  try { api->enableSamplingProfiler(100); }
  catch (...) { _failure = @"Hermes sampling is unavailable."; reject(@"sampler", _failure, nil); return; }
  samplerOwner = self;
  _recording = YES;
  _watchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _queue);
  dispatch_source_set_timer(_watchdog, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), DISPATCH_TIME_FOREVER, 0);
  __weak VerityCPUProfiler *weakSelf = self;
  dispatch_source_set_event_handler(_watchdog, ^{ [weakSelf finish:@"deadline"]; });
  dispatch_resume(_watchdog);
  resolve([self snapshot]);
}
RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self finish:@"manual"];
  resolve([self snapshot]);
}
RCT_EXPORT_METHOD(exportCapture:(NSString *)context resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self enabled] || _recording || !_captureID || _failure) {
    reject(@"unavailable", _failure ?: @"Stop a CPU recording before exporting.", nil); return;
  }
  NSError *error;
  NSData *raw = [NSData dataWithContentsOfURL:self.rawURL options:NSDataReadingMappedIfSafe error:&error];
  NSDictionary *profile = raw ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:&error] : nil;
  NSData *contextData = [context dataUsingEncoding:NSUTF8StringEncoding];
  if (contextData.length > 1024 * 1024) { reject(@"size", @"Diagnostic context exceeds 1 MiB.", nil); return; }
  id diagnostics = [NSJSONSerialization JSONObjectWithData:contextData options:0 error:&error];
  if (![profile isKindOfClass:NSDictionary.class] || ![profile[@"samples"] isKindOfClass:NSArray.class] ||
      [profile[@"samples"] count] == 0 || ![diagnostics isKindOfClass:NSDictionary.class]) {
    reject(@"empty", @"No usable Hermes samples. This build's sampler must be verified on the device.", error); return;
  }
  BOOL mainJS = NO;
  for (NSDictionary *sample in profile[@"samples"]) {
    if ([[sample[@"tid"] description] isEqual:_jsThreadID]) { mainJS = YES; break; }
  }
  if (!mainJS) {
    reject(@"runtime", @"Profile does not contain the app JavaScript thread. Close other profilers and retry.", nil); return;
  }
  NSDictionary *current = [VerityProfileBundleIdentity snapshotAndReturnError:&error];
  if (!current || ![current isEqual:_bundleIdentity]) {
    reject(@"identity", @"The running bundle changed; record again after restart.", error); return;
  }
  NSMutableDictionary *identity = [_bundleIdentity mutableCopy];
  identity[@"samplingHz"] = @100;
  identity[@"jsThreadId"] = _jsThreadID;
  NSDictionary *capture = @{@"schema": @2, @"recording": [self snapshot], @"identity": identity,
    @"diagnostics": diagnostics, @"hermesProfile": profile};
  NSData *data = [NSJSONSerialization dataWithJSONObject:capture options:0 error:&error];
  NSURL *output = [_directory URLByAppendingPathComponent:@"verity-cpu-capture.json"];
  if (!data || ![data writeToURL:output options:NSDataWritingAtomic error:&error]) {
    reject(@"storage", @"Could not write CPU capture.", error); return;
  }
  resolve(output.absoluteString);
}
- (void)invalidate {
  void (^cleanup)(void) = ^{ [self finish:@"invalidate"]; self->_invalidated = YES; };
  if (dispatch_get_specific((__bridge const void *)self)) cleanup();
  else dispatch_sync(_queue, cleanup);
  if (_backgroundObserver) [[NSNotificationCenter defaultCenter] removeObserver:_backgroundObserver];
}
@end
