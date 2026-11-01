// The SDK's five native modules on iOS, each a thin door to the one native side the app shares
// (NecessaryNative, in NecessaryNative.swift). The specs they conform to are generated from
// src/native/*.ts.

#import <React/RCTBridgeModule.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <NecessarySpec/NecessarySpec.h>

@interface NecessaryInstallationKey : NSObject <NativeNecessaryInstallationKeySpec>
@end
@interface NecessaryIntegrity : NSObject <NativeNecessaryIntegritySpec>
@end
@interface NecessaryStepUpKey : NSObject <NativeNecessaryStepUpKeySpec>
@end
@interface NecessarySecureScreen : NSObject <NativeNecessarySecureScreenSpec>
@end
@interface NecessaryStorage : NSObject <NativeNecessaryStorageSpec>
@end

#else

@interface NecessaryInstallationKey : NSObject <RCTBridgeModule>
@end
@interface NecessaryIntegrity : NSObject <RCTBridgeModule>
@end
@interface NecessaryStepUpKey : NSObject <RCTBridgeModule>
@end
@interface NecessarySecureScreen : NSObject <RCTBridgeModule>
@end
@interface NecessaryStorage : NSObject <RCTBridgeModule>
@end

#endif
