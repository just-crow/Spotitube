pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral(); maven("https://jitpack.io") { content { includeGroup("com.github.MetrolistGroup.innertubex"); includeGroup("com.github.MetrolistGroup.quackjs"); includeGroupByRegex("com[.]github[.]TeamNewPipe.*") } } } }
rootProject.name = "Spotitube"
include(":app")


