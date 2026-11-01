#import "NecessaryModules.h"

#if __has_include(<NecessaryReactNative/NecessaryReactNative-Swift.h>)
#import <NecessaryReactNative/NecessaryReactNative-Swift.h>
#else
#import "NecessaryReactNative-Swift.h"
#endif

// A refusal from the native side, as React Native's promise takes it: its code and its words.
static void (^Rejecting(RCTPromiseRejectBlock reject))(NSString *, NSString *) {
  return ^(NSString *code, NSString *message) {
    reject(code, message, nil);
  };
}

static NSArray<NSString *> *Strings(NSArray *items) {
  NSMutableArray<NSString *> *strings = [NSMutableArray arrayWithCapacity:items.count];
  for (id item in items) {
    if ([item isKindOfClass:[NSString class]]) {
      [strings addObject:item];
    }
  }
  return strings;
}

@implementation NecessaryInstallationKey

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(getOrCreateKey : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared getOrCreateKeyWithResolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(sign : (NSString *)payload resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared signWithPayload:payload resolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(deleteKey : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared deleteKeyWithResolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(reinstallHintIdentifier : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared reinstallHintIdentifierWithResolve:resolve reject:Rejecting(reject)];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNecessaryInstallationKeySpecJSI>(params);
}
#endif

@end

@implementation NecessaryIntegrity

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(collect : (NSArray *)requiredProbes challengeNonce : (NSString *)challengeNonce optionalProbes : (
    NSArray *)optionalProbes enabledMeasurements : (NSArray *)enabledMeasurements resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared collectWithRequiredProbes:Strings(requiredProbes)
                                     challengeNonce:challengeNonce
                                     optionalProbes:Strings(optionalProbes)
                                enabledMeasurements:Strings(enabledMeasurements)
                                            resolve:resolve
                                             reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(requestLocationPermission : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared requestLocationPermissionWithResolve:resolve reject:Rejecting(reject)];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNecessaryIntegritySpecJSI>(params);
}
#endif

@end

@implementation NecessaryStepUpKey

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// iOS makes per-use keys only: the mode and the window are Android's.
RCT_EXPORT_METHOD(getOrCreateKey : (NSString *)factor mode : (NSString *)mode windowSeconds : (double)
                      windowSeconds resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared getOrCreateStepUpKeyWithFactor:factor resolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(sign : (NSString *)payload reason : (NSString *)reason mode : (NSString *)mode resolve : (
    RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared signStepUpWithPayload:payload reason:reason resolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(deleteKey : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared deleteStepUpKeyWithResolve:resolve reject:Rejecting(reject)];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNecessaryStepUpKeySpecJSI>(params);
}
#endif

@end

@implementation NecessarySecureScreen

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(protect : (BOOL)on resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared protectWithOn:on resolve:resolve reject:Rejecting(reject)];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNecessarySecureScreenSpecJSI>(params);
}
#endif

@end

@implementation NecessaryStorage

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(read : (NSString *)key resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared readWithKey:key
                              resolve:^(id value) {
                                resolve(value == [NSNull null] ? nil : value);
                              }
                               reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(write : (NSString *)key value : (NSString *)value resolve : (RCTPromiseResolveBlock)
                      resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared writeWithKey:key value:value resolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(remove : (NSString *)key resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared removeWithKey:key resolve:resolve reject:Rejecting(reject)];
}

RCT_EXPORT_METHOD(randomBytes : (double)count resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [NecessaryNative.shared randomBytesWithCount:(NSInteger)count resolve:resolve reject:Rejecting(reject)];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNecessaryStorageSpecJSI>(params);
}
#endif

@end
