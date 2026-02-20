{
  "variables": {
    # Detect arch: arm64 → MacOSX-ARM64, x86_64 → MacOSX-x86-64
    # Override the whole path by setting WSTP_DIR in the environment.
    "wstp_dir%": "<!(echo \"${WSTP_DIR:-/Applications/Wolfram 3.app/Contents/SystemFiles/Links/WSTP/DeveloperKit/$(uname -m | sed 's/x86_64/MacOSX-x86-64/;s/arm64/MacOSX-ARM64/')/CompilerAdditions}\")"
  },
  "targets": [
    {
      "target_name": "wstp",
      "sources": ["src/addon.cc"],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(wstp_dir)"
      ],

      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],

      "libraries": [
        # The static library ships as libWSTPi4.a in the macOS DeveloperKit.
        "<(wstp_dir)/libWSTPi4.a"
      ],

      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-Wall", "-Wextra"]
          },
          "link_settings": {
            "libraries": [
              "-framework Foundation",
              "-framework SystemConfiguration",
              "-framework CoreFoundation"
            ]
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "-Wall", "-Wextra"],
          "libraries": ["-lrt", "-lpthread", "-ldl", "-lm"]
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          },
          "libraries": ["<(wstp_dir)/wstp64i4s.lib"]
        }]
      ]
    }
  ]
}
