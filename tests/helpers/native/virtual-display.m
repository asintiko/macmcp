// Test tool: adds a virtual display to the Mac for as long as it runs.
//
//   virtual-display <width> <height> <hidpi 0|1>
//
// Width and height are the size of the display in points; with hidpi 1 the display has twice
// as many pixels in each direction (a "Retina" display). When the display exists the tool
// prints one line, "display <id>", and then waits until it is killed.
//
// It uses the CGVirtualDisplay classes of CoreGraphics, which have no public header; the
// declarations below are the ones other projects (Chromium's display tests among them) use.
// The classes are looked up at run time so that a macOS without them fails with a message
// instead of a link error.

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

@protocol MCVirtualDisplayMode <NSObject>
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@protocol MCVirtualDisplaySettings <NSObject>
@property(nonatomic) unsigned int hiDPI;
@property(retain, nonatomic) NSArray *modes;
@end

@protocol MCVirtualDisplayDescriptor <NSObject>
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@optional
- (void)setDispatchQueue:(dispatch_queue_t)queue;
- (void)setQueue:(dispatch_queue_t)queue;
@end

@protocol MCVirtualDisplay <NSObject>
- (instancetype)initWithDescriptor:(id)descriptor;
- (BOOL)applySettings:(id)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end

static void fail(NSString *message) {
  fprintf(stderr, "virtual-display: %s\n", message.UTF8String);
  exit(1);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 4) {
      fprintf(stderr, "usage: virtual-display <width> <height> <hidpi 0|1>\n");
      return 2;
    }
    unsigned int width = (unsigned int)atoi(argv[1]);
    unsigned int height = (unsigned int)atoi(argv[2]);
    unsigned int hiDPI = atoi(argv[3]) != 0 ? 1 : 0;
    unsigned int factor = hiDPI ? 2 : 1;

    Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
    Class displayClass = NSClassFromString(@"CGVirtualDisplay");
    Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
    Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
    if (!descriptorClass || !displayClass || !settingsClass || !modeClass) fail(@"this macOS has no CGVirtualDisplay");

    id<MCVirtualDisplayDescriptor> descriptor = [[descriptorClass alloc] init];
    if ([descriptor respondsToSelector:@selector(setDispatchQueue:)]) [descriptor setDispatchQueue:dispatch_get_main_queue()];
    else if ([descriptor respondsToSelector:@selector(setQueue:)]) [descriptor setQueue:dispatch_get_main_queue()];
    descriptor.name = @"mcpclaude test display";
    descriptor.maxPixelsWide = width * factor;
    descriptor.maxPixelsHigh = height * factor;
    // About 110 points per inch, like a desktop monitor.
    descriptor.sizeInMillimeters = CGSizeMake(width * 25.4 / 110.0, height * 25.4 / 110.0);
    descriptor.vendorID = 0x4D43;
    descriptor.productID = 0x1001 + hiDPI;
    descriptor.serialNum = 0x0001;
    descriptor.terminationHandler = ^(id context, id display) {
      fprintf(stderr, "virtual-display: the display was removed by macOS\n");
      exit(1);
    };

    id<MCVirtualDisplay> display = [(id<MCVirtualDisplay>)[displayClass alloc] initWithDescriptor:descriptor];
    if (!display) fail(@"macOS refused to create a virtual display");

    id<MCVirtualDisplaySettings> settings = [[settingsClass alloc] init];
    settings.hiDPI = hiDPI;
    id<MCVirtualDisplayMode> mode = [(id<MCVirtualDisplayMode>)[modeClass alloc] initWithWidth:width height:height refreshRate:60.0];
    settings.modes = @[ mode ];
    if (![display applySettings:settings]) fail(@"macOS refused the display mode");

    printf("display %u\n", display.displayID);
    fflush(stdout);
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
