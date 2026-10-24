// Run on Windows or macOS. No CocoaPods, XcodeGen, backend or downloaded runtime.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ios = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(ios, 'MORA/Resources');
await fs.mkdir(resources, { recursive: true });
await build({ entryPoints: [path.join(ios, 'core-entry.ts')], outfile: path.join(resources, 'mora-core.js'), bundle: true, format: 'iife', globalName: 'MoraCore', platform: 'neutral', target: 'es2019', legalComments: 'eof' });

const id = name => createHash('sha256').update(`mora-ios/${name}`).digest('hex').slice(0, 24).toUpperCase();
const sources = (await fs.readdir(path.join(ios, 'MORA'))).filter(n => n.endsWith('.swift')).sort();
const q = JSON.stringify;
const configs = (owner, type) => ['Debug', 'Release'].map(name => `${id(owner + name)} = {isa = XCBuildConfiguration; name = ${name}; buildSettings = {${type === 'project' ? `SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; CLANG_ENABLE_MODULES = YES; ${name === 'Debug' ? 'SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf;' : 'SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'}` : 'PRODUCT_NAME = MORA; PRODUCT_BUNDLE_IDENTIFIER = ru.mora.ios; INFOPLIST_FILE = MORA/Info.plist; CODE_SIGN_STYLE = Automatic; TARGETED_DEVICE_FAMILY = "1,2"; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SWIFT_EMIT_LOC_STRINGS = YES; ENABLE_PREVIEWS = YES;'} }; };`).join('\n');
const pbx = `// !$*UTF8*$!
{archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
${sources.map(n => `${id('ref'+n)} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${q(n)}; sourceTree = "<group>"; };
${id('build'+n)} = {isa = PBXBuildFile; fileRef = ${id('ref'+n)}; };`).join('\n')}
${id('jsref')} = {isa = PBXFileReference; lastKnownFileType = sourcecode.javascript; path = "Resources/mora-core.js"; sourceTree = "<group>"; };
${id('jsbuild')} = {isa = PBXBuildFile; fileRef = ${id('jsref')}; };
${id('product')} = {isa = PBXFileReference; explicitFileType = wrapper.application; path = MORA.app; sourceTree = BUILT_PRODUCTS_DIR; };
${id('root')} = {isa = PBXGroup; children = (${id('sources')}, ${id('products')}); sourceTree = "<group>"; };
${id('sources')} = {isa = PBXGroup; path = MORA; children = (${sources.map(n => id('ref'+n)).join(',')}, ${id('jsref')}); sourceTree = "<group>"; };
${id('products')} = {isa = PBXGroup; name = Products; children = (${id('product')}); sourceTree = "<group>"; };
${id('sourcephase')} = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${sources.map(n => id('build'+n)).join(',')}); runOnlyForDeploymentPostprocessing = 0; };
${id('resourcephase')} = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (${id('jsbuild')}); runOnlyForDeploymentPostprocessing = 0; };
${id('frameworkphase')} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
${id('target')} = {isa = PBXNativeTarget; name = MORA; productName = MORA; productReference = ${id('product')}; productType = "com.apple.product-type.application"; buildConfigurationList = ${id('targetconfigs')}; buildPhases = (${id('sourcephase')}, ${id('frameworkphase')}, ${id('resourcephase')}); buildRules = (); dependencies = (); };
${id('project')} = {isa = PBXProject; attributes = {LastUpgradeCheck = 1600; }; buildConfigurationList = ${id('projectconfigs')}; compatibilityVersion = "Xcode 14.0"; developmentRegion = ru; knownRegions = (ru, en, Base); mainGroup = ${id('root')}; productRefGroup = ${id('products')}; projectDirPath = ""; projectRoot = ""; targets = (${id('target')}); };
${configs('project','project')}
${configs('target','target')}
${['project','target'].map(owner => `${id(owner+'configs')} = {isa = XCConfigurationList; buildConfigurations = (${id(owner+'Debug')}, ${id(owner+'Release')}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };`).join('\n')}
}; rootObject = ${id('project')}; }
`;
const project = path.join(ios, 'MORA.xcodeproj');
await fs.mkdir(path.join(project, 'xcshareddata/xcschemes'), { recursive: true });
await fs.writeFile(path.join(project, 'project.pbxproj'), pbx);
await fs.writeFile(path.join(project, 'xcshareddata/xcschemes/MORA.xcscheme'), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id('target')}" BuildableName="MORA.app" BlueprintName="MORA" ReferencedContainer="container:MORA.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id('target')}" BuildableName="MORA.app" BlueprintName="MORA" ReferencedContainer="container:MORA.xcodeproj"/></BuildableProductRunnable></LaunchAction><ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id('target')}" BuildableName="MORA.app" BlueprintName="MORA" ReferencedContainer="container:MORA.xcodeproj"/></BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>`);
console.log('iOS project + static AutoMix planner prepared:', project);
